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

export type Result<TValue> = { ok: true; value: TValue } | { ok: false; error: string };
export const ok = <TValue>(value: TValue): Result<TValue> => ({ ok: true, value });
export const err = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** `parseConfig` for games that take no config: accepts a missing or null config, rejects anything else. */
export const noConfig = (input: unknown): Result<null> =>
  input === undefined || input === null ? ok(null) : err('This game takes no config');

export type Outcome = { winners: PlayerId[] } | { draw: true };

export type SetupContext<TConfig> = {
  /** Players in join order. */
  players: PlayerId[];
  /** Config as returned by `parseConfig`. */
  config: TConfig;
  /** Per-game random seed. Store whatever RNG state you need inside your game state. */
  seed: string;
};

/**
 * @typeParam TState  The game's JSON-serializable state.
 * @typeParam TMove   A validated move, as produced by `parseMove`. Needn't be JSON:
 *                    the server stores the raw input, not this value.
 * @typeParam TConfig The game's validated config, as produced by `parseConfig`.
 */
export interface GameDefinition<TState extends Json = Json, TMove = Json, TConfig extends Json = Json> {
  /** Unique identifier, e.g. "tic-tac-toe". */
  type: string;
  minPlayers: number;
  maxPlayers: number;

  /**
   * Validate untrusted config from the create-game request (`undefined` when none was sent).
   * Games without config can use `noConfig`.
   */
  parseConfig(input: unknown): Result<TConfig>;

  /** Build the initial state once the game starts. */
  setup(ctx: SetupContext<TConfig>): TState;

  /**
   * Validate an untrusted move from a client and turn it into a typed `TMove`.
   * Check both its shape and whether it's legal in this state (e.g. the cell is empty).
   * An error becomes a 400 response, and `applyMove` is not called.
   *
   * The server only calls this when `player` is in `activePlayers(state)`.
   */
  parseMove(input: unknown, state: TState, player: PlayerId): Result<TMove>;

  /**
   * The ONLY state transition: apply a move that `parseMove` accepted and return the next state.
   * Must be pure (return a new value; do not rely on side effects). It may still return an
   * error for rules that are easier to check while applying.
   *
   * Simultaneous moves: record the player's commitment in state (e.g. `pending[player]`)
   * and, when the last commitment arrives, resolve the round in the same call.
   */
  applyMove(state: TState, move: TMove, player: PlayerId): Result<TState>;

  /**
   * Who may act right now. Return several players for simultaneous phases,
   * and [] when nobody can act. Note: this list is public.
   */
  activePlayers(state: TState): PlayerId[];

  /** Read-only "is the game over?" query. Return null while the game continues. */
  outcome(state: TState): Outcome | null;

  /**
   * Redact state for a viewer (`null` = spectator / public stream).
   * Every state the server sends out goes through this.
   * Defaults to the full state — ANY GAME WITH HIDDEN INFORMATION MUST IMPLEMENT THIS.
   */
  view?(state: TState, viewer: PlayerId | null): Json;
}

/** Identity helper that gives you type inference when defining a game. */
export function defineGame<TState extends Json, TMove = Json, TConfig extends Json = Json>(
  definition: GameDefinition<TState, TMove, TConfig>,
): GameDefinition<TState, TMove, TConfig> {
  return definition;
}

// ---------------------------------------------------------------------------
// Wire protocol types shared by the server and clients.
// ---------------------------------------------------------------------------

export type GameStatus = 'lobby' | 'active' | 'finished';

export type PublicPlayer = { id: PlayerId; name: string };

type GameViewBase = {
  id: string;
  type: string;
  /** Increments on every change (join, start, move). */
  version: number;
  players: PublicPlayer[];
  activePlayers: PlayerId[];
  outcome: Outcome | null;
  /** The player this view was rendered for, or null for spectators. */
  you: PlayerId | null;
};

/** A game still waiting for players. It has no state yet: `setup` runs when the game starts. */
export type LobbyGameView = GameViewBase & { status: 'lobby' };

/** A game that has started. `state` has already been passed through the game's `view`. */
export type StartedGameView = GameViewBase & { status: 'active' | 'finished'; state: Json };

/** What any client sees of a game. Check `status` to narrow it: only started games have `state`. */
export type GameView = LobbyGameView | StartedGameView;

export type JoinResponse = { playerId: PlayerId; key: string; game: GameView };

export type GameTypeInfo = { type: string; minPlayers: number; maxPlayers: number };

/**
 * Error codes the server can return. An object rather than a TS `enum`, because enums
 * aren't erasable syntax and Node's type stripping rejects them. The values are the
 * strings sent on the wire, so clients can compare against either.
 */
export const ErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_MOVE: 'INVALID_MOVE',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type ErrorResponse = { error: { code: ErrorCode; message: string } };
