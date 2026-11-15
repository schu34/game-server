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

export type Decisions<D extends Json> = { [player: PlayerId]: D };

export type ResolveContext = TransitionContext & {
  /** 1-based number of the round being resolved. */
  round: number;
  /** Deciders who did not submit a decision (only non-empty when the round timed out). */
  missing: PlayerId[];
  timedOut: boolean;
};

export type SimultaneousGameDefinition<S extends Json, D extends Json, C extends Json = Json> = {
  type: string;
  minPlayers: number;
  maxPlayers: number;
  parseConfig?(input: unknown): Result<C>;

  /** Initial game state. */
  setup(ctx: SetupContext<C>): S;

  /** Validate one player's untrusted decision. Called on submit, so bad input is rejected immediately. */
  parseDecision(state: S, input: unknown, player: PlayerId): Result<D>;

  /** Process all decisions for the round and return the next state. Starts the next round. */
  resolve(state: S, decisions: Decisions<D>, ctx: ResolveContext): S;

  outcome(state: S): Outcome | null;

  /** Who must decide this round (e.g. exclude eliminated players). Default: everyone. */
  deciders?(state: S, players: PlayerId[]): PlayerId[];

  /** May players replace their decision until the round resolves? Default false (decisions are final). */
  allowRevision?: boolean;

  /**
   * Per-round time limit in ms, or null for none. When it expires, the round resolves with
   * whatever was submitted, and `ctx.missing` lists who didn't decide. Your `resolve` decides
   * what missing means (ignore them, apply a default, eliminate them...).
   */
  timeLimitMs?(state: S): number | null;

  /** Redact your own game state per viewer. Pending decisions are hidden for you regardless. */
  view?(state: S, viewer: PlayerId | null): Json;
};

/** The state the server stores for a simultaneous game: your state plus round bookkeeping. */
export type SimultaneousState<S extends Json, D extends Json> = {
  players: PlayerId[];
  round: number;
  roundStartedAt: number;
  decisions: Decisions<D>;
  game: S;
};

/** What clients see. Other players' pending decisions are never included. */
export type SimultaneousView<D extends Json> = {
  round: number;
  /** Players who must decide this round. */
  deciders: PlayerId[];
  /** Deciders who have submitted (public, so everyone can see who we're waiting on). */
  decided: PlayerId[];
  waitingOn: PlayerId[];
  /** Your own pending decision this round, if any. */
  yourDecision: D | null;
  roundDeadline: number | null;
  game: Json;
};

export function defineSimultaneousGame<S extends Json, D extends Json, C extends Json = Json>(
  spec: SimultaneousGameDefinition<S, D, C>,
): GameDefinition<SimultaneousState<S, D>, C> {
  type State = SimultaneousState<S, D>;

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

  const definition: GameDefinition<State, C> = {
    type: spec.type,
    minPlayers: spec.minPlayers,
    maxPlayers: spec.maxPlayers,

    setup(ctx) {
      return { players: ctx.players, round: 1, roundStartedAt: ctx.now, decisions: {}, game: spec.setup(ctx) };
    },

    applyMove(state, input, player, ctx) {
      if (player in state.decisions && !spec.allowRevision) return { ok: false, error: 'You have already decided this round' };
      const decision = spec.parseDecision(state.game, input, player);
      if (!decision.ok) return decision;

      const next: State = { ...state, decisions: { ...state.decisions, [player]: decision.value } };
      return { ok: true, value: undecided(next).length === 0 ? resolveRound(next, ctx.now, false) : next };
    },

    activePlayers(state) {
      if (spec.outcome(state.game)) return [];
      return spec.allowRevision ? deciders(state) : undecided(state);
    },

    outcome: (state) => spec.outcome(state.game),

    view(state, viewer): SimultaneousView<D> {
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

  if (spec.parseConfig) definition.parseConfig = spec.parseConfig;
  if (spec.timeLimitMs) {
    definition.deadline = roundDeadline;
    definition.onDeadline = (state, ctx) => resolveRound(state, ctx.now, true);
  }
  return definition;
}
