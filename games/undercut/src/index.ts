/**
 * Undercut: a many-player bluffing game with no turn order.
 *
 * Every player holds the same hand of cards numbered 1 to 8. Each round has two steps:
 *
 * 1. Pick: everyone secretly picks two cards from their hand. Then all pairs are revealed.
 * 2. Play: knowing everyone's pair, each player secretly plays one of their two cards.
 *
 * The lowest card that nobody else played wins the round and earns a token. Cards played
 * by more than one player cancel out, so the next lowest unique card wins; if every card was
 * matched, nobody wins. The played card is discarded and the other one goes back to the hand.
 *
 * Rounds come in cycles of six, and each cycle starts with a fresh hand of 1 to 8. At the end
 * of every cycle but the last, the player with the most tokens is safe and leaves the game.
 * When the last cycle ends, the remaining player with the most tokens wins and the one with
 * the fewest is eliminated. Ties go to whoever won a round most recently.
 */
import { produce } from 'immer';
import { defineSimultaneousGame, err, ok, type Outcome, type PlayerId, type SimultaneousState } from '@gs/sdk';

export const DECK: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const ROUNDS_PER_CYCLE = 6;
export const MAX_CYCLES = 5;

export type Config = {
  cycles: number;
  /** Time limit for each pick and each play, in ms, or null to wait for everyone. */
  decisionTimeMs: number | null;
};

/** A pick is two different cards from your hand; a play is one card from your revealed pair. */
export type Decision = { pick: number[] } | { play: number };

export type PlayerStatus = 'playing' | 'safe' | 'eliminated' | 'winner';

export type Seat = {
  hand: number[];
  tokens: number;
  status: PlayerStatus;
  /** The last round this player won, for breaking ties. */
  lastWin: number | null;
};

export type RoundResult = {
  round: number;
  pairs: { [player: PlayerId]: number[] };
  played: { [player: PlayerId]: number };
  winner: PlayerId | null;
  /** Players whose card was chosen for them because time ran out. */
  autoPlayed: PlayerId[];
};

export type CycleResult = {
  cycle: number;
  /** Who was safe after this cycle (null on the last cycle, or when nobody could be). */
  safe: PlayerId | null;
};

export type UndercutGame = {
  cycles: number;
  decisionTimeMs: number | null;
  /** 1-based game round; rounds 1-6 are cycle 1, and so on. */
  round: number;
  step: 'pick' | 'play';
  seats: { [player: PlayerId]: Seat };
  /** This round's revealed pairs. Empty during the pick step. */
  pairs: { [player: PlayerId]: number[] };
  history: RoundResult[];
  cycleResults: CycleResult[];
  finished: boolean;
};

export type UndercutState = SimultaneousState<UndercutGame, Decision>;

export const cycleOf = (round: number) => Math.ceil(round / ROUNDS_PER_CYCLE);
const totalRounds = (game: UndercutGame) => game.cycles * ROUNDS_PER_CYCLE;
const playing = (game: UndercutGame) => Object.keys(game.seats).filter((p) => game.seats[p]!.status === 'playing');

function parseConfig(input: unknown) {
  const { cycles = 3, decisionTimeMs = null } = (input ?? {}) as { cycles?: unknown; decisionTimeMs?: unknown };
  if (!Number.isInteger(cycles) || (cycles as number) < 1 || (cycles as number) > MAX_CYCLES) {
    return err(`cycles must be an integer from 1 to ${MAX_CYCLES}`);
  }
  if (decisionTimeMs !== null && (!Number.isInteger(decisionTimeMs) || (decisionTimeMs as number) < 1)) {
    return err('decisionTimeMs must be a positive integer or null');
  }
  return ok<Config>({ cycles: cycles as number, decisionTimeMs: decisionTimeMs as number | null });
}

/** The lowest card played by exactly one player wins; matched cards cancel out. */
export function roundWinner(played: { [player: PlayerId]: number }): PlayerId | null {
  const counts = new Map<number, number>();
  for (const card of Object.values(played)) counts.set(card, (counts.get(card) ?? 0) + 1);
  const unique = [...counts].filter(([, n]) => n === 1).map(([card]) => card);
  if (unique.length === 0) return null;
  const lowest = Math.min(...unique);
  return Object.keys(played).find((p) => played[p] === lowest)!;
}

/** Players in ranking order: most tokens first, ties broken by the most recent round win. */
export function ranking(game: UndercutGame, players: PlayerId[]): PlayerId[] {
  const key = (p: PlayerId) => [game.seats[p]!.tokens, game.seats[p]!.lastWin ?? 0] as const;
  return [...players].sort((a, b) => {
    const [ta, wa] = key(a);
    const [tb, wb] = key(b);
    return tb - ta || wb - wa;
  });
}

/** True if neither tokens nor the last-win tiebreak separates the two players. */
function tied(game: UndercutGame, a: PlayerId, b: PlayerId): boolean {
  const sa = game.seats[a]!;
  const sb = game.seats[b]!;
  return sa.tokens === sb.tokens && (sa.lastWin ?? 0) === (sb.lastWin ?? 0);
}

/** Players who timed out get their two highest cards, then the higher of their pair: the weakest choices. */
const autoPick = (hand: number[]) => [...hand].sort((a, b) => a - b).slice(-2);
const autoPlay = (pair: number[]) => Math.max(...pair);

function resolvePick(game: UndercutGame, decisions: { [player: PlayerId]: Decision }): UndercutGame {
  return produce(game, (draft) => {
    for (const p of playing(game)) {
      const decision = decisions[p];
      draft.pairs[p] = decision && 'pick' in decision ? decision.pick : autoPick(game.seats[p]!.hand);
    }
    draft.step = 'play';
  });
}

function resolvePlay(game: UndercutGame, decisions: { [player: PlayerId]: Decision }): UndercutGame {
  const played: { [player: PlayerId]: number } = {};
  const autoPlayed: PlayerId[] = [];
  for (const p of playing(game)) {
    const decision = decisions[p];
    if (decision && 'play' in decision) played[p] = decision.play;
    else {
      played[p] = autoPlay(game.pairs[p]!);
      autoPlayed.push(p);
    }
  }
  const winner = roundWinner(played);

  return produce(game, (draft) => {
    for (const [p, card] of Object.entries(played)) {
      const seat = draft.seats[p]!;
      seat.hand = seat.hand.filter((c) => c !== card); // only the played card is discarded
    }
    if (winner) {
      draft.seats[winner]!.tokens += 1;
      draft.seats[winner]!.lastWin = game.round;
    }
    draft.history.push({ round: game.round, pairs: game.pairs, played, winner, autoPlayed });
    draft.pairs = {};
    draft.step = 'pick';

    if (game.round % ROUNDS_PER_CYCLE === 0) endCycle(draft);
    draft.round += 1;
  });
}

/** Called on the last round of a cycle, with `game.round` still set to that round. */
function endCycle(game: UndercutGame): void {
  const cycle = cycleOf(game.round);
  const remaining = ranking(game, playing(game));

  if (game.round < totalRounds(game)) {
    // The leader is safe and leaves, unless the lead is tied or only two players would be left.
    const [leader, runnerUp] = remaining;
    const canLeave =
      remaining.length > 2 && leader !== undefined && (runnerUp === undefined || !tied(game, leader, runnerUp));
    if (canLeave) game.seats[leader!]!.status = 'safe';
    game.cycleResults.push({ cycle, safe: canLeave ? leader! : null });
    for (const p of playing(game)) game.seats[p]!.hand = [...DECK];
    return;
  }

  // Last cycle: the leader (and anyone tied with them) wins, and the last place is eliminated.
  const leader = remaining[0]!;
  const last = remaining[remaining.length - 1]!;
  const winners = remaining.filter((p) => tied(game, p, leader));
  const losers = tied(game, leader, last) ? [] : remaining.filter((p) => tied(game, p, last));
  for (const p of winners) game.seats[p]!.status = 'winner';
  for (const p of losers) game.seats[p]!.status = 'eliminated';
  game.cycleResults.push({ cycle, safe: null });
  game.finished = true;
}

function outcome(game: UndercutGame): Outcome | null {
  if (!game.finished) return null;
  return { winners: Object.keys(game.seats).filter((p) => game.seats[p]!.status === 'winner') };
}

export const undercut = defineSimultaneousGame<UndercutGame, Decision, Config>({
  type: 'undercut',
  minPlayers: 3,
  maxPlayers: 10,
  parseConfig,

  setup: ({ players, config }) => ({
    cycles: config.cycles,
    decisionTimeMs: config.decisionTimeMs,
    round: 1,
    step: 'pick',
    seats: Object.fromEntries(
      players.map((p) => [p, { hand: [...DECK], tokens: 0, status: 'playing', lastWin: null }]),
    ),
    pairs: {},
    history: [],
    cycleResults: [],
    finished: false,
  }),

  deciders: (game) => (game.finished ? [] : playing(game)),

  parseDecision(input, game, player) {
    const seat = game.seats[player]!;
    if (game.step === 'pick') {
      const pick = (input as { pick?: unknown } | null)?.pick;
      if (!Array.isArray(pick) || pick.length !== 2 || !pick.every((c) => Number.isInteger(c))) {
        return err('Pick two cards: { "pick": [a, b] }');
      }
      const [a, b] = pick as [number, number];
      if (a === b) return err('Pick two different cards');
      const missing = [a, b].filter((c) => !seat.hand.includes(c));
      if (missing.length) return err(`Not in your hand: ${missing.join(', ')}`);
      return ok<Decision>({ pick: [Math.min(a, b), Math.max(a, b)] });
    }

    const card = (input as { play?: unknown } | null)?.play;
    const pair = game.pairs[player]!;
    if (!Number.isInteger(card) || !pair.includes(card as number)) {
      return err(`Play one of your revealed cards: { "play": ${pair[0]} } or { "play": ${pair[1]} }`);
    }
    return ok<Decision>({ play: card as number });
  },

  resolve: (game, decisions) => (game.step === 'pick' ? resolvePick(game, decisions) : resolvePlay(game, decisions)),

  timeLimitMs: (game) => game.decisionTimeMs,
  outcome,
});
