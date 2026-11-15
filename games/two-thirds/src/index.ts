/**
 * Two-thirds of the average: a many-player game with no turn order.
 *
 * Each round, every player secretly guesses a whole number from 0 to 100. Once everyone
 * has guessed (or the optional round timer runs out), guesses are revealed and whoever is
 * closest to 2/3 of the average guess scores a point. Players may change their guess
 * until the round resolves. Most points after the last round wins.
 */
import { defineSimultaneousGame, err, ok, type Outcome, type PlayerId, type SimultaneousState } from '@gs/sdk';

export type Config = {
  rounds: number;
  /** Per-round time limit in ms, or null to wait for everyone. */
  roundTimeMs: number | null;
};

export type RoundResult = {
  guesses: { [player: PlayerId]: number };
  /** Players who didn't guess before time ran out; they can't score that round. */
  missing: PlayerId[];
  average: number | null;
  target: number | null;
  winners: PlayerId[];
};

export type TwoThirdsGame = {
  rounds: number;
  roundTimeMs: number | null;
  scores: { [player: PlayerId]: number };
  history: RoundResult[];
};

export type TwoThirdsState = SimultaneousState<TwoThirdsGame, number>;

export const MAX_ROUNDS = 20;

function parseConfig(input: unknown) {
  const { rounds = 3, roundTimeMs = null } = (input ?? {}) as { rounds?: unknown; roundTimeMs?: unknown };
  if (!Number.isInteger(rounds) || (rounds as number) < 1 || (rounds as number) > MAX_ROUNDS) {
    return err(`rounds must be an integer from 1 to ${MAX_ROUNDS}`);
  }
  if (roundTimeMs !== null && (!Number.isInteger(roundTimeMs) || (roundTimeMs as number) < 1)) {
    return err('roundTimeMs must be a positive integer or null');
  }
  return ok<Config>({ rounds: rounds as number, roundTimeMs: roundTimeMs as number | null });
}

export function scoreRound(guesses: { [player: PlayerId]: number }, missing: PlayerId[]): RoundResult {
  const values = Object.values(guesses);
  if (values.length === 0) return { guesses, missing, average: null, target: null, winners: [] };

  const average = values.reduce((sum, g) => sum + g, 0) / values.length;
  const target = (2 / 3) * average;
  const distance = (g: number) => Math.abs(g - target);
  const best = Math.min(...values.map(distance));
  const winners = Object.keys(guesses).filter((p) => distance(guesses[p]!) === best);
  return { guesses, missing, average, target, winners };
}

function outcome(game: TwoThirdsGame): Outcome | null {
  if (game.history.length < game.rounds) return null;
  const players = Object.keys(game.scores);
  const top = Math.max(...players.map((p) => game.scores[p]!));
  const winners = players.filter((p) => game.scores[p] === top);
  return winners.length === players.length ? { draw: true } : { winners };
}

export const twoThirds = defineSimultaneousGame<TwoThirdsGame, number, Config>({
  type: 'two-thirds',
  minPlayers: 2,
  maxPlayers: 20,
  allowRevision: true,
  parseConfig,

  setup: ({ players, config }) => ({
    rounds: config.rounds,
    roundTimeMs: config.roundTimeMs,
    scores: Object.fromEntries(players.map((p) => [p, 0])),
    history: [],
  }),

  parseDecision(input) {
    const guess = (input as { guess?: unknown } | null)?.guess;
    return Number.isInteger(guess) && (guess as number) >= 0 && (guess as number) <= 100
      ? ok(guess as number)
      : err('Move must be { "guess": 0-100 }');
  },

  resolve(game, guesses, { missing }) {
    const result = scoreRound(guesses, missing);
    const scores = { ...game.scores };
    for (const winner of result.winners) scores[winner] = (scores[winner] ?? 0) + 1;
    return { ...game, scores, history: [...game.history, result] };
  },

  timeLimitMs: (game) => game.roundTimeMs,
  outcome,
});
