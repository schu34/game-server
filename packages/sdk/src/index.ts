/**
 * @gs/sdk — the contract between the generic game server and individual games.
 *
 * A game is a set of PURE functions over JSON-serializable state. Games do no I/O,
 * read no clocks, and keep no hidden module-level state; the server owns storage,
 * auth, turn enforcement, and transport.
 *
 * Declare state/config with `type` aliases (not `interface`) so TypeScript can
 * check them against `Json`.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type PlayerId = string;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (error: string): { ok: false; error: string } => ({ ok: false, error });

export type Outcome = { winners: PlayerId[] } | { draw: true };

export type SetupContext<C> = {
  /** Players in join order. */
  players: PlayerId[];
  /** Config as returned by `parseConfig` (or the raw config if not defined). */
  config: C;
  /** Per-game random seed. Store whatever RNG state you need inside your game state. */
  seed: string;
};

export interface GameDefinition<S extends Json = Json, C extends Json = Json> {
  /** Unique identifier, e.g. "tic-tac-toe". */
  type: string;
  minPlayers: number;
  maxPlayers: number;

  /** Validate untrusted config from the create-game request. Defaults to accepting it as-is. */
  parseConfig?(input: unknown): Result<C>;

  /** Build the initial state once the game starts. */
  setup(ctx: SetupContext<C>): S;

  /**
   * The ONLY state transition. Validate the untrusted `move` and return the next state.
   * Must be pure (return a new value; do not rely on side effects).
   *
   * The server only calls this when `player` is in `activePlayers(state)`.
   *
   * Simultaneous moves: record the player's commitment in state (e.g. `pending[player]`)
   * and, when the last commitment arrives, resolve the round in the same call.
   */
  applyMove(state: S, move: unknown, player: PlayerId): Result<S>;

  /**
   * Who may act right now. Return several players for simultaneous phases,
   * and [] when nobody can act. Note: this list is public.
   */
  activePlayers(state: S): PlayerId[];

  /** Read-only "is the game over?" query. Return null while the game continues. */
  outcome(state: S): Outcome | null;

  /**
   * Redact state for a viewer (`null` = spectator / public stream).
   * Every state the server sends out goes through this.
   * Defaults to the full state — ANY GAME WITH HIDDEN INFORMATION MUST IMPLEMENT THIS.
   */
  view?(state: S, viewer: PlayerId | null): Json;
}

/** Identity helper that gives you type inference when defining a game. */
export function defineGame<S extends Json, C extends Json = Json>(
  definition: GameDefinition<S, C>,
): GameDefinition<S, C> {
  return definition;
}

// ---------------------------------------------------------------------------
// Wire protocol types shared by the server and clients.
// ---------------------------------------------------------------------------

export type GameStatus = 'lobby' | 'active' | 'finished';

export type PublicPlayer = { id: PlayerId; name: string };

/** What any client sees of a game. `state` has already been passed through `view`. */
export type GameView = {
  id: string;
  type: string;
  status: GameStatus;
  /** Increments on every change (join, start, move). */
  version: number;
  players: PublicPlayer[];
  activePlayers: PlayerId[];
  outcome: Outcome | null;
  state: Json | null;
  /** The player this view was rendered for, or null for spectators. */
  you: PlayerId | null;
};

export type JoinResponse = { playerId: PlayerId; key: string; game: GameView };

export type GameTypeInfo = { type: string; minPlayers: number; maxPlayers: number };

export type ErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'NOT_YOUR_TURN'
  | 'INVALID_MOVE'
  | 'INVALID_REQUEST'
  | 'CONFLICT'
  | 'INTERNAL';

export type ErrorResponse = { error: { code: ErrorCode; message: string } };
