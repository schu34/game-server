/**
 * defineSimultaneousGame: for games with no turn order, where every player makes a decision,
 * and once everyone has decided, all decisions are processed together.
 *
 * You write `parseDecision` (validate one decision) and `resolve` (process them all);
 * this helper produces an ordinary GameDefinition that handles collecting decisions,
 * keeping them hidden, knowing who is still undecided, optional revisions, and
 * optional per-round time limits. The server needs no special support for it.
 */
import type { GameDefinition, Json, Outcome, PlayerId, Result, SetupContext, TransitionContext } from './index.ts';

export type Decisions<TDecision extends Json> = { [player: PlayerId]: TDecision };

export type ResolveContext = TransitionContext & {
  /** 1-based number of the round being resolved. */
  round: number;
  /** Deciders who did not submit a decision (only non-empty when the round timed out). */
  missing: PlayerId[];
  timedOut: boolean;
};

/**
 * @typeParam TState    Your game state (without the round bookkeeping, which the helper adds).
 * @typeParam TDecision One player's validated decision. JSON, because pending decisions are stored in state.
 * @typeParam TConfig   Your validated config.
 */
export type SimultaneousGameDefinition<TState extends Json, TDecision extends Json, TConfig extends Json = Json> = {
  type: string;
  minPlayers: number;
  maxPlayers: number;
  /** Validate untrusted config, as in `GameDefinition.parseConfig`; use `noConfig` if the game takes none. */
  parseConfig(input: unknown): Result<TConfig>;

  /** Initial game state. */
  setup(ctx: SetupContext<TConfig>): TState;

  /**
   * Validate one player's untrusted decision. Called on submit, so bad input is rejected immediately.
   * Same argument order as `GameDefinition.parseMove`.
   */
  parseDecision(input: unknown, state: TState, player: PlayerId): Result<TDecision>;

  /** Process all decisions for the round and return the next state. Starts the next round. */
  resolve(state: TState, decisions: Decisions<TDecision>, ctx: ResolveContext): TState;

  outcome(state: TState): Outcome | null;

  /** Who must decide this round (e.g. exclude eliminated players). Default: everyone. */
  deciders?(state: TState, players: PlayerId[]): PlayerId[];

  /** May players replace their decision until the round resolves? Default false (decisions are final). */
  allowRevision?: boolean;

  /**
   * Per-round time limit in ms, or null for none. When it expires, the round resolves with
   * whatever was submitted, and `ctx.missing` lists who didn't decide. Your `resolve` decides
   * what missing means (ignore them, apply a default, eliminate them...).
   */
  timeLimitMs?(state: TState): number | null;

  /** Redact your own game state per viewer. Pending decisions are hidden for you regardless. */
  view?(state: TState, viewer: PlayerId | null): Json;
};

/** The state the server stores for a simultaneous game: your state plus round bookkeeping. */
export type SimultaneousState<TState extends Json, TDecision extends Json> = {
  players: PlayerId[];
  round: number;
  roundStartedAt: number;
  decisions: Decisions<TDecision>;
  game: TState;
};

/** What clients see. Other players' pending decisions are never included. */
export type SimultaneousView<TDecision extends Json> = {
  round: number;
  /** Players who must decide this round. */
  deciders: PlayerId[];
  /** Deciders who have submitted (public, so everyone can see who we're waiting on). */
  decided: PlayerId[];
  waitingOn: PlayerId[];
  /** Your own pending decision this round, if any. */
  yourDecision: TDecision | null;
  roundDeadline: number | null;
  game: Json;
};

export function defineSimultaneousGame<TState extends Json, TDecision extends Json, TConfig extends Json = Json>(
  spec: SimultaneousGameDefinition<TState, TDecision, TConfig>,
): GameDefinition<SimultaneousState<TState, TDecision>, TDecision, TConfig> {
  type State = SimultaneousState<TState, TDecision>;

  const deciders = (state: State) => (spec.deciders ? spec.deciders(state.game, state.players) : state.players);
  const undecided = (state: State) => deciders(state).filter((p) => !(p in state.decisions));
  const roundDeadline = (state: State): number | null => {
    if (spec.outcome(state.game)) return null;
    const limit = spec.timeLimitMs?.(state.game) ?? null;
    return limit === null ? null : state.roundStartedAt + limit;
  };

  const resolveRound = (state: State, now: number, timedOut: boolean): State => {
    const round = state.round;
    const missing = undecided(state);
    const game = spec.resolve(state.game, state.decisions, { now, round, missing, timedOut });
    return { ...state, game, round: round + 1, roundStartedAt: now, decisions: {} };
  };

  const definition: GameDefinition<State, TDecision, TConfig> = {
    type: spec.type,
    minPlayers: spec.minPlayers,
    maxPlayers: spec.maxPlayers,
    parseConfig: spec.parseConfig,

    setup(ctx) {
      return { players: ctx.players, round: 1, roundStartedAt: ctx.now, decisions: {}, game: spec.setup(ctx) };
    },

    parseMove(input, state, player) {
      if (player in state.decisions && !spec.allowRevision) return { ok: false, error: 'You have already decided this round' };
      return spec.parseDecision(input, state.game, player);
    },

    applyMove(state, decision, player, ctx) {
      const next: State = { ...state, decisions: { ...state.decisions, [player]: decision } };
      return { ok: true, value: undecided(next).length === 0 ? resolveRound(next, ctx.now, false) : next };
    },

    activePlayers(state) {
      if (spec.outcome(state.game)) return [];
      return spec.allowRevision ? deciders(state) : undecided(state);
    },

    outcome: (state) => spec.outcome(state.game),

    view(state, viewer): SimultaneousView<TDecision> {
      const all = deciders(state);
      return {
        round: state.round,
        deciders: all,
        decided: all.filter((p) => p in state.decisions),
        waitingOn: undecided(state),
        yourDecision: viewer !== null && viewer in state.decisions ? state.decisions[viewer]! : null,
        roundDeadline: roundDeadline(state),
        game: spec.view ? spec.view(state.game, viewer) : state.game,
      };
    },
  };

  if (spec.timeLimitMs) {
    definition.deadline = roundDeadline;
    definition.onDeadline = (state, ctx) => resolveRound(state, ctx.now, true);
  }
  return definition;
}
