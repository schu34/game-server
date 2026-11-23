/**
 * Game-agnostic React glue over @gs/client. Nothing here knows about tic-tac-toe: this file is
 * the candidate for a shared `@gs/react` package if more web UIs appear.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameServer, type PlayerSession, type Seat, type Spectator } from '@gs/client';
import type { GameView, Json } from '@gs/sdk';

export const server = new GameServer(import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000');

// ---------------------------------------------------------------------------
// Seats: a player's key, remembered per game so a reload keeps your place.
// ---------------------------------------------------------------------------

const seatStorageKey = (gameId: string) => `gs:seat:${gameId}`;

function loadSeat(gameId: string): Seat | null {
  try {
    const raw = localStorage.getItem(seatStorageKey(gameId));
    return raw ? (JSON.parse(raw) as Seat) : null;
  } catch {
    return null;
  }
}

function saveSeat(gameId: string, seat: Seat): void {
  try {
    localStorage.setItem(seatStorageKey(gameId), JSON.stringify(seat));
  } catch {
    // Storage is unavailable (private mode, blocked): the seat lasts until the page reloads.
  }
}

/** This browser's seat in a game, if it has one, and a way to take one. */
export function useSeat<TState extends Json, TMove extends Json>(gameId: string) {
  const [session, setSession] = useState(() => {
    const seat = loadSeat(gameId);
    return seat ? server.session<TState, TMove>(gameId, seat) : null;
  });
  const spectator = useMemo(() => server.spectate<TState>(gameId), [gameId]);

  const join = useCallback(
    async (name: string) => {
      const joined = await server.join<TState, TMove>(gameId, name);
      saveSeat(gameId, joined.seat);
      setSession(joined);
    },
    [gameId],
  );

  /** The session if seated, so reads and streams show this player's own view; else the spectator. */
  const viewer: Spectator<TState> = session ?? spectator;
  return { session, viewer, join };
}

/** Create a game and take the first seat in it. Returns the game's id. */
export async function createAndJoin(type: string, name: string, config?: Json): Promise<string> {
  const game = await server.create(type, config);
  const session = await server.join(game.id, name);
  saveSeat(game.id, session.seat);
  return game.id;
}

// ---------------------------------------------------------------------------
// The live game.
// ---------------------------------------------------------------------------

export type LiveGame<TState extends Json, TMove extends Json> = {
  /** The latest view, or null until the first one arrives. */
  view: GameView<TState> | null;
  /** Why the stream failed, if it did. It keeps reconnecting, and this clears when it's back. */
  error: Error | null;
  /** Submit a move (seated players only). The view updates as soon as the server accepts it. */
  move(move: TMove): Promise<void>;
  /** True while a move is in flight. */
  pending: boolean;
  /** Why the last move was rejected, if it was. Cleared by the next move. */
  moveError: Error | null;
};

/** Stream `viewer`'s view of the game, and submit moves through `session`. */
export function useGame<TState extends Json, TMove extends Json>(
  viewer: Spectator<TState>,
  session: PlayerSession<TState, TMove> | null,
): LiveGame<TState, TMove> {
  const [view, setView] = useState<GameView<TState> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const [moveError, setMoveError] = useState<Error | null>(null);
  const latest = useRef(-1);

  // Views come from the stream and from move responses; keep whichever is newest.
  const accept = useCallback((next: GameView<TState>) => {
    if (next.version <= latest.current) return;
    latest.current = next.version;
    setView(next);
  }, []);

  useEffect(() => {
    let closed = false;
    const close: (() => void)[] = [];
    latest.current = -1;
    setView(null);
    setError(null);
    viewer
      .subscribe(
        (next) => {
          setError(null);
          accept(next);
        },
        { onError: setError },
      )
      .then(
        (subscription) => (closed ? subscription.close() : close.push(subscription.close)),
        (e: unknown) => !closed && setError(e as Error),
      );
    return () => {
      closed = true;
      close.forEach((fn) => fn());
    };
  }, [viewer, accept]);

  const move = useCallback(
    async (m: TMove) => {
      if (!session) throw new Error('Only seated players can move');
      setPending(true);
      setMoveError(null);
      try {
        accept(await session.move(m));
      } catch (e) {
        setMoveError(e as Error);
      } finally {
        setPending(false);
      }
    },
    [session, accept],
  );

  return { view, error, move, pending, moveError };
}
