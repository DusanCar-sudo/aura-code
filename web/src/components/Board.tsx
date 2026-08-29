import { useMemo } from 'react';
import { buildBoard, type BoardCard } from '../lib/board';
import type { Message } from '../hooks/useAura';

type T = (key: string) => string;

/**
 * The full-page Kanban view.
 *
 * Read-only by design, and the design is the point — see lib/board.ts. Cards
 * are a projection of what the agent did, so there is nothing to drag: moving
 * a card would be asking the board to disagree with the run it describes.
 *
 * Columns scroll independently and the row itself scrolls horizontally, so a
 * long column never squashes the others and a narrow window keeps every stage
 * reachable rather than hiding the ones that did not fit.
 */
export function Board({ messages, awaitingApproval, t }: {
  messages: Message[];
  /** Name of the tool the operator is being asked about, or null. It is the
   *  only signal that tells "ready to execute" apart from "executing". */
  awaitingApproval: string | null;
  t: T;
}) {
  const board = useMemo(
    () => buildBoard(messages, awaitingApproval),
    [messages, awaitingApproval],
  );

  if (board.total === 0) {
    return (
      <div className="board board-empty">
        <p className="board-empty-text">{t('board.empty')}</p>
      </div>
    );
  }

  return (
    <div className="board">
      {board.columns.map(({ column, cards }) => (
        <section className="board-col" key={column} aria-label={t(`board.col.${column}`)}>
          <header className="board-col-head">
            <h2 className="board-col-title">{t(`board.col.${column}`)}</h2>
            <span className="board-col-count">{cards.length}</span>
          </header>
          <div className="board-col-cards">
            {cards.map((card) => <Card key={card.id} card={card} t={t} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function Card({ card, t }: { card: BoardCard; t: T }) {
  return (
    <article className={`board-card board-card-${card.outcome}${card.isTask ? ' board-card-task' : ''}`}>
      <div className="board-card-head">
        <span className="board-card-title">{card.title}</span>
        <span className="board-card-turn">{t('board.turn')} {card.turn}</span>
      </div>
      {card.detail && <div className="board-card-detail" title={card.detail}>{card.detail}</div>}
      <div className="board-card-foot">
        <span className={`board-badge board-badge-${card.outcome}`}>
          {t(`board.status.${card.outcome}`)}
        </span>
        {/* Sub-second calls are the common case and rendering "0.0s" for all of
            them is noise, so timing appears only once it is worth reading. */}
        {card.elapsedMs !== undefined && card.elapsedMs >= 100 && (
          <span className="board-card-time">{(card.elapsedMs / 1000).toFixed(1)}s</span>
        )}
      </div>
    </article>
  );
}
