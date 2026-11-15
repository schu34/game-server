/**
 * Test-only games. The server's tests deliberately don't use any real game package,
 * which keeps the server honest about being game-agnostic.
 */
import { defineGame, err, ok, type PlayerId } from '@gs/sdk';

// --- Sequential: players take turns adding 1-3; whoever reaches the target wins. ---------

export type CounterState = { players: PlayerId[]; turn: number; count: number; target: number };

export type CounterMove = { add: 1 | 2 | 3 };

export const counterGame = defineGame<CounterState, CounterMove, { target: number }>({
  type: 'counter',
  minPlayers: 2,
  maxPlayers: 3,
  parseConfig(input) {
    if (input === undefined || input === null) return ok({ target: 10 });
    const target = (input as { target?: unknown }).target;
    return Number.isInteger(target) && (target as number) > 0 ? ok({ target: target as number }) : err('target must be a positive integer');
  },
  setup: ({ players, config }) => ({ players, turn: 0, count: 0, target: config.target }),
  parseMove(input) {
    const add = (input as { add?: unknown } | null)?.add;
    return add === 1 || add === 2 || add === 3 ? ok({ add }) : err('add must be 1, 2 or 3');
  },
  applyMove(state, { add }) {
    const count = state.count + add;
    return ok({ ...state, count, turn: count >= state.target ? state.turn : (state.turn + 1) % state.players.length });
  },
  activePlayers: (state) => (state.count >= state.target ? [] : [state.players[state.turn]!]),
  outcome: (state) => (state.count >= state.target ? { winners: [state.players[state.turn]!] } : null),
});

// --- Simultaneous: everyone secretly picks 1-10 each round; highest unique pick scores. --

export type SecretPickState = {
  players: PlayerId[];
  rounds: number;
  pending: { [player: PlayerId]: number };
  history: { [player: PlayerId]: number }[];
  scores: { [player: PlayerId]: number };
};

export type SecretPickMove = { pick: number };

export const secretPickGame = defineGame<SecretPickState, SecretPickMove, { rounds: number }>({
  type: 'secret-pick',
  minPlayers: 2,
  maxPlayers: 4,
  parseConfig: (input) => {
    const rounds = (input as { rounds?: unknown } | undefined)?.rounds ?? 2;
    return Number.isInteger(rounds) && (rounds as number) > 0 ? ok({ rounds: rounds as number }) : err('rounds must be a positive integer');
  },
  setup: ({ players, config }) => ({
    players,
    rounds: config.rounds,
    pending: {},
    history: [],
    scores: Object.fromEntries(players.map((p) => [p, 0])),
  }),
  parseMove(input) {
    const pick = (input as { pick?: unknown } | null)?.pick;
    return Number.isInteger(pick) && (pick as number) >= 1 && (pick as number) <= 10
      ? ok({ pick: pick as number })
      : err('pick must be 1-10');
  },
  applyMove(state, { pick }, player) {
    const pending = { ...state.pending, [player]: pick };
    if (Object.keys(pending).length < state.players.length) return ok({ ...state, pending });

    // Last commitment arrived: reveal and resolve the round in this same transition.
    const counts = new Map<number, number>();
    for (const value of Object.values(pending)) counts.set(value, (counts.get(value) ?? 0) + 1);
    const best = Math.max(...Object.values(pending).filter((v) => counts.get(v) === 1), 0);
    const scores = { ...state.scores };
    for (const [p, value] of Object.entries(pending)) if (value === best) scores[p] = (scores[p] ?? 0) + 1;
    return ok({ ...state, pending: {}, history: [...state.history, pending], scores });
  },
  activePlayers: (state) =>
    state.history.length >= state.rounds ? [] : state.players.filter((p) => !(p in state.pending)),
  outcome(state) {
    if (state.history.length < state.rounds) return null;
    const top = Math.max(...Object.values(state.scores));
    const winners = state.players.filter((p) => state.scores[p] === top);
    return winners.length === state.players.length ? { draw: true } : { winners };
  },
  view: (state, viewer) => ({
    ...state,
    // Committed-but-hidden picks show as null; you only see your own.
    pending: Object.fromEntries(Object.entries(state.pending).map(([p, v]) => [p, p === viewer ? v : null])),
  }),
});
