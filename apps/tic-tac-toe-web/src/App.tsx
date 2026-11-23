import { useState, type SubmitEvent } from 'react';
import type { GameView } from '@gs/sdk';
import type { Cell, TicTacToeMove, TicTacToeState } from '@gs/game-tic-tac-toe';
import { createAndJoin, useGame, useSeat } from './game-react.ts';

type View = GameView<TicTacToeState>;

const NAME_KEY = 'gs:name';

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not remembered; that's fine.
  }
}

export function App() {
  const gameId = new URLSearchParams(location.search).get('game');
  return (
    <main>
      <h1>
        <a href="/">Tic-tac-toe</a>
      </h1>
      {gameId ? <GameScreen gameId={gameId} /> : <Home />}
    </main>
  );
}

function Home() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(name: string) {
    setBusy(true);
    try {
      const id = await createAndJoin('tic-tac-toe', name);
      location.search = `?game=${encodeURIComponent(id)}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <p>Start a game, then send the link to a friend.</p>
      <NameForm label="New game" busy={busy} onSubmit={create} />
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function NameForm({ label, busy, onSubmit }: { label: string; busy: boolean; onSubmit(name: string): void }) {
  const [name, setName] = useState(rememberedName);
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    rememberName(trimmed);
    onSubmit(trimmed);
  }
  return (
    <form className="name-form" onSubmit={submit}>
      <input
        aria-label="Your name"
        placeholder="Your name"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={busy || !name.trim()}>
        {label}
      </button>
    </form>
  );
}

function GameScreen({ gameId }: { gameId: string }) {
  const seat = useSeat<TicTacToeState, TicTacToeMove>(gameId);
  const game = useGame(seat.viewer, seat.session);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function join(name: string) {
    setJoining(true);
    setJoinError(null);
    try {
      await seat.join(name);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  }

  const { view } = game;
  if (!view) {
    return <p className={game.error ? 'error' : 'muted'}>{game.error ? game.error.message : 'Connecting…'}</p>;
  }

  const state = view.status === 'lobby' ? null : view.state; // typed: no cast
  const canJoin = !seat.session && view.status === 'lobby';
  const myTurn = view.status === 'active' && view.you !== null && view.activePlayers.includes(view.you);

  return (
    <section className="card">
      <Players view={view} state={state} />
      <p className="status" role="status">
        {statusLine(view, state)}
      </p>

      {state && (
        <Board board={state.board} enabled={myTurn && !game.pending} onPlay={(cell) => void game.move({ cell })} />
      )}
      {game.moveError && <p className="error">{game.moveError.message}</p>}
      {game.error && <p className="error">Connection lost, reconnecting… ({game.error.message})</p>}

      {canJoin && <NameForm label="Join game" busy={joining} onSubmit={join} />}
      {joinError && <p className="error">{joinError}</p>}
      {view.status === 'lobby' && seat.session && <ShareLink />}
      {view.status === 'finished' && <a href="/">New game</a>}
    </section>
  );
}

function Players({ view, state }: { view: View; state: TicTacToeState | null }) {
  return (
    <ul className="players">
      {view.players.map((p) => (
        <li key={p.id} className={view.activePlayers.includes(p.id) ? 'active' : ''}>
          <span className="mark">{state?.marks[p.id] ?? '·'}</span> {p.name}
          {p.id === view.you && <span className="muted"> (you)</span>}
        </li>
      ))}
    </ul>
  );
}

function statusLine(view: View, state: TicTacToeState | null): string {
  const name = (id: string) => view.players.find((p) => p.id === id)?.name ?? id;
  if (view.status === 'lobby') return 'Waiting for a second player…';
  if (view.outcome) {
    if ('draw' in view.outcome) return "It's a draw.";
    const [winner] = view.outcome.winners;
    return winner === view.you ? 'You win!' : `${name(winner!)} wins.`;
  }
  const turn = state!.turn;
  if (turn === view.you) return 'Your turn.';
  return `${name(turn)}'s turn.`;
}

function Board({ board, enabled, onPlay }: { board: Cell[]; enabled: boolean; onPlay(cell: number): void }) {
  return (
    <div className="board" role="grid" aria-label="Board">
      {board.map((cell, i) => (
        <button
          key={i}
          className="cell"
          disabled={!enabled || cell !== null}
          aria-label={`Cell ${i + 1}${cell ? `, ${cell}` : ''}`}
          onClick={() => onPlay(i)}
        >
          {cell}
        </button>
      ))}
    </div>
  );
}

function ShareLink() {
  const [copied, setCopied] = useState(false);
  const url = location.href;
  return (
    <p className="share">
      Invite someone: <code>{url}</code>{' '}
      <button
        type="button"
        onClick={() =>
          navigator.clipboard.writeText(url).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </p>
  );
}
