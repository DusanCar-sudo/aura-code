import { useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import {
  BOARD_COLUMNS, isOrderable, orderBetween, tasksIn,
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
  /**
   * The tile being dragged, and where the pointer is.
   *
   * Pointer events rather than HTML5 drag-and-drop. The native API refuses to
   * start a drag from several ordinary places (a <button>, which is most of a
   * tile), does not fire at all in a window the browser considers unfocused,
   * and gives no control over the drag image — it was reported as "I can't
   * move the boxes" twice before this was replaced. Pointer events are what
   * every kanban that works actually uses.
   */
  const [drag, setDrag] = useState<{
    id: string; x: number; y: number;
    /** Where inside the tile it was grabbed, so the ghost does not jump to its
     *  own corner the moment it appears. */
    dx?: number; dy?: number;
    w?: number;
  } | null>(null);
  /**
   * A pointer is down on a tile, but it is not a drag yet.
   *
   * The whole tile is grabbable — asking someone to find a ten-pixel handle is
   * how "I can't move the boxes" happens — so a press has to stay ambiguous
   * until it moves. Under the threshold it is a click and opens the editor;
   * over it, the tile comes with you.
   */
  const pending = useRef<
    { id: string; x: number; y: number; dx: number; dy: number; w: number } | null
  >(null);
  const dragging = drag?.id ?? null;
  /** The tile a cable is being pulled from, if any. Separate from `dragging`
   *  because dropping a cable links two tasks and dropping a tile moves one —
   *  the same gesture on the same element meaning two things would be a coin
   *  toss for the user. */
  const boardRef = useRef<HTMLDivElement | null>(null);

  /** Where a drop at this point would land: the column, and the index in it. */
  const targetAt = (x: number, y: number): { column: BoardColumn; at: number } | null => {
    const el = document.elementFromPoint(x, y);
    const col = el?.closest<HTMLElement>('.board-col');
    const column = BOARD_COLUMNS.find((c) => col?.classList.contains(`board-col-${c}`));
    if (!column) return null;

    // Index by midpoint: above a tile's centre means before it. Anything below
    // the last tile is the end of the column.
    const tiles = [...(col?.querySelectorAll<HTMLElement>('.board-card') ?? [])]
      .filter((t) => t.dataset.taskId !== dragging);
    let at = tiles.length;
    for (let i = 0; i < tiles.length; i++) {
      const box = tiles[i].getBoundingClientRect();
      if (y < box.top + box.height / 2) { at = i; break; }
    }
    return { column, at };
  };

  const endDrag = (x: number, y: number) => {
    const held = drag;
    setDrag(null);
    if (!held) return;
    const target = targetAt(x, y);
    if (target) void drop(board, held.id, target.column, target.at);
  };

  return (
    <div className="board-wrap">
      {board.error && <div className="board-bar"><span className="board-error">{board.error}</span></div>}

      <div
        className={`board${drag ? ' board-dragging' : ''}`}
        ref={boardRef}
        onPointerMove={(e) => {
          if (drag) { setDrag({ ...drag, x: e.clientX, y: e.clientY }); return; }
          const p = pending.current;
          if (!p) return;
          // 5px, so a slightly unsteady click is still a click.
          if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 5) return;
          pending.current = null;
          setDrag({ id: p.id, x: e.clientX, y: e.clientY, dx: p.dx, dy: p.dy, w: p.w });
        }}
        onPointerUp={(e) => { pending.current = null; endDrag(e.clientX, e.clientY); }}
        // A pointer that leaves the window mid-drag must not leave the board
        // stuck holding a tile that no longer follows it.
        onPointerCancel={() => { pending.current = null; setDrag(null); }}
      >
        {BOARD_COLUMNS.map((column) => {
          const cards = tasksIn(board.tasks, column);
          return (
            <section
              className={`board-col board-col-${column}`}
              key={column}
              aria-label={t(`board.col.${column}`)}
            >
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
                  <Icon name="plus" size="1.05em" />
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
                {cards.map((task, at) => (
                  <Tile
                    key={task.id}
                    task={task}
                    board={board}
                    busy={busy}
                    open={editing === task.id}
                    onToggle={() => setEditing(editing === task.id ? null : task.id)}
                    onRun={onRun}
                    dragging={dragging}
                    onPress={(id, x, y, dx, dy, w) => { pending.current = { id, x, y, dx, dy, w }; }}
                    onGrab={(id, x, y) => setDrag({ id, x, y })}
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

      {/* The tile under the pointer.
          Without this the gesture worked and looked like nothing was
          happening: the reorder only landed on release, so a drag in progress
          showed no movement at all and the board read as frozen. A drag has to
          be visible while it is a drag. */}
      {drag && (() => {
        const held = board.tasks.find((x) => x.id === drag.id);
        if (!held) return null;
        return (
          <div
            className="board-ghost"
            style={{
              left: drag.x - (drag.dx ?? 0),
              top: drag.y - (drag.dy ?? 0),
              width: drag.w,
            }}
          >
            <div className="board-ghost-title">{held.title}</div>
            {held.notes && <div className="board-ghost-notes">{held.notes}</div>}
          </div>
        );
      })()}
    </div>
  );
}

/**
 * Move a dragged tile to a column, at a position.
 *
 * Position is only honoured where it means something: `finished` is a record
 * of what happened, ordered by when, so a drop there moves the tile into the
 * column and leaves the sequence alone rather than pretending the arrangement
 * was kept.
 */
async function drop(
  board: BoardApi,
  id: string,
  column: BoardColumn,
  at: number,
): Promise<void> {
  const task = board.tasks.find((t) => t.id === id);
  if (!task) return;

  if (!isOrderable(column)) {
    if (task.column !== column) await board.update(id, { column });
    return;
  }

  // Neighbours as the column will look *without* the tile being moved, or a
  // tile dropped one place down from where it already is lands back where it
  // started, and the drag appears to have done nothing.
  const others = tasksIn(board.tasks, column).filter((t) => t.id !== id);
  const order = orderBetween(others[at - 1], others[at]);
  await board.update(id, { column, order });
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


/** Something the agent can look at, or something it can read. */
function fileIcon(type: string): IconName {
  return type.startsWith('image/') ? 'image' : 'file';
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
              <Icon name={fileIcon(a.type)} size="0.9em" /> {a.name}
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
        <Icon name="paperclip" size="1em" /> {busy ? t('board.filesBusy') : t('board.filesAdd')}
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

function Tile({
  task, board, busy, open, onToggle, onRun,
  dragging, onPress, onGrab, t,
}: {
  task: BoardTask;
  board: BoardApi;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onRun: (task: BoardTask) => void;
  dragging: string | null;
  /** A press anywhere on the tile — becomes a drag if it moves. */
  onPress: (id: string, x: number, y: number, dx: number, dy: number, w: number) => void;
  onGrab: (id: string, x: number, y: number) => void;
  t: T;
}) {
  const preset = board.presets.find((p) => p.id === task.agent);
  const next = nextColumn(task.column);
  const prev = prevColumn(task.column);
  // Advancing out of `preparation` is a dispatch, not a move: it spends money
  // and can edit files, so it is labelled for what it does and is the only
  // control disabled while another task is running.
  const advanceRuns = task.column === 'preparation';

  const classes = [
    'board-card',
    task.failed ? 'board-card-failed' : '',
    task.column === 'execution' ? 'board-card-running' : '',
    task.priority === 'urgent' ? 'board-card-urgent' : '',
    task.attention ? 'board-card-attention' : '',
    dragging === task.id ? 'board-card-dragging' : '',
  ].filter(Boolean).join(' ');

  const linked = task.linkedTo ? board.tasks.find((x) => x.id === task.linkedTo) : undefined;
  const state = task.failed ? 'failed'
    : task.attention ? 'attention'
    : task.column === 'execution' ? 'running'
    : task.column === 'finished' ? 'done'
    : 'idle';

  return (
    <article
      className={classes}
      data-task-id={task.id}
      onPointerDown={(e) => {
        // Everything except the real controls. The face is deliberately NOT
        // excluded even though it is a <button>: it covers the title, which is
        // exactly where a person grabs a card, so skipping buttons wholesale
        // left only the thin margins draggable and the tile felt stuck. The
        // 5px threshold already tells a click on it from a drag.
        const el = e.target as HTMLElement;
        if (el.closest('input, textarea, select')) return;
        if (el.closest('button') && !el.closest('.board-card-face')) return;
        const box = e.currentTarget.getBoundingClientRect();
        onPress(
          task.id, e.clientX, e.clientY,
          e.clientX - box.left, e.clientY - box.top, box.width,
        );
      }}
    >
      {/* The drag handle is its own element, and has to be. The whole tile was
          draggable at first, but the face below it is a <button> covering most
          of the card, and a browser will not start a drag from a button — so
          the gesture was swallowed almost everywhere the user would grab. */}
      <span
        className="board-grip"
        title={t('board.dragHint')}
        aria-label={t('board.dragHint')}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Capture on the board, not the grip: the pointer spends the whole
          // drag over other elements, and without capture the move events stop
          // arriving the moment it leaves this 14px span.
          onGrab(task.id, e.clientX, e.clientY);
        }}
      >
        <Icon name="grip" size="1.05em" />
      </span>

      <button
        type="button"
        className="board-card-face"
        // A drag that ends over this tile would otherwise also register as a
        // click and flip the editor open, so the press that moved something
        // does two things at once.
        onClick={() => { if (!dragging) onToggle(); }}
        aria-expanded={open}
      >
        {/* The state, as one small mark. It replaces a 2px coloured edge down
            the side of the card: a stripe that size reads as a container being
            decorated, and at four possible colours it turned every column into
            a set of differently-trimmed boxes. A dot states the same thing and
            leaves the card a card. */}
        <span className={`board-dot board-dot-${state}`} aria-hidden="true" />
        <span className="board-card-title">{task.title}</span>
        <span className="board-card-agent">{preset?.label ?? task.agent}</span>
      </button>


      {linked && (
        <div className="board-card-link" title={t('board.linkHint')}>
          <Icon name="link" size="0.9em" /> {linked.title}
        </div>
      )}

      {task.notes && !open && <div className="board-card-detail">{task.notes}</div>}

      {!open && !!task.attachments?.length && (
        <div className="board-card-files">
          {task.attachments.map((a) => (
            <span className="board-file" key={a.path}>
              <Icon name={fileIcon(a.type)} size="0.9em" /> {a.name}
            </span>
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

          <div className="board-flags">
            <button
              type="button"
              className={`board-flag${task.priority === 'urgent' ? ' board-flag-on board-flag-urgent' : ''}`}
              onClick={() => void board.update(task.id, {
                priority: task.priority === 'urgent' ? 'normal' : 'urgent',
              })}
            >
              {t('board.urgent')}
            </button>
            <button
              type="button"
              className={`board-flag${task.attention ? ' board-flag-on board-flag-attention' : ''}`}
              onClick={() => void board.update(task.id, { attention: !task.attention })}
            >
              {t('board.attention')}
            </button>
          </div>

          <label className="board-field">
            <span className="board-field-label">{t('board.linkTo')}</span>
            <select
              className="board-input"
              value={task.linkedTo ?? ''}
              onChange={(e) => void board.update(task.id, { linkedTo: e.target.value })}
            >
              <option value="">{t('board.linkNone')}</option>
              {/* Only tasks still in planning: the connector pulls work
                  forward, and offering something already finished would
                  promise a move that cannot happen. */}
              {board.tasks
                .filter((x) => x.id !== task.id && x.column === 'planning')
                .map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
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
            <Icon name="arrow-left" size="1em" />
          </button>
        )}
        {next && (
          advanceRuns ? (
            <button
              type="button"
              className="board-run"
              // A task is blocked only by its own run, never by somebody
              // else's. Each board task gets its own engine session, and the
              // engine's one-turn-at-a-time rule is per session — so the only
              // thing that was serialising the board was this button reading a
              // global "the chat is streaming" flag that has nothing to do
              // with it.
              disabled={task.column === 'execution'}
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
              <Icon name="arrow-right" size="1em" />
            </button>
          )
        )}
      </div>
    </article>
  );
}
