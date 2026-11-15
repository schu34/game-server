import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineSimultaneousGame, err, ok, type Result, type SimultaneousState, type SimultaneousView } from '../src/index.ts';

// Each round every (non-eliminated) player picks a number; it's added to their total.
type SumState = { totals: { [p: string]: number }; eliminated: string[]; rounds: number; log: { missing: string[]; timedOut: boolean }[] };

function sumGame(options: { allowRevision?: boolean; timeLimitMs?: number } = {}) {
  return defineSimultaneousGame<SumState, number>({
    type: 'sum',
    minPlayers: 2,
    maxPlayers: 5,
    ...(options.allowRevision ? { allowRevision: true } : {}),
    ...(options.timeLimitMs ? { timeLimitMs: () => options.timeLimitMs! } : {}),
    setup: ({ players }) => ({ totals: Object.fromEntries(players.map((p) => [p, 0])), eliminated: [], rounds: 2, log: [] }),
    deciders: (state, players) => players.filter((p) => !state.eliminated.includes(p)),
    parseDecision: (_state, input) => (Number.isInteger(input) ? ok(input as number) : err('pick an integer')),
    resolve(state, decisions, { missing, timedOut }) {
      const totals = { ...state.totals };
      for (const [p, n] of Object.entries(decisions)) totals[p] = (totals[p] ?? 0) + n;
      return { ...state, totals, log: [...state.log, { missing, timedOut }] };
    },
    outcome: (state) => (state.log.length >= state.rounds ? { draw: true } : null),
  });
}

type S = SimultaneousState<SumState, number>;
const start = (game: ReturnType<typeof sumGame>, players = ['a', 'b', 'c'], now = 1000) =>
  game.setup({ players, config: null, seed: 's', now });

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const decide = (game: ReturnType<typeof sumGame>, state: S, player: string, n: unknown, now = 1000) =>
  game.applyMove(state, n, player, { now });

describe('defineSimultaneousGame', () => {
  it('waits for every decider, then resolves all decisions together', () => {
    const game = sumGame();
    let state = start(game);
    assert.deepEqual(game.activePlayers(state), ['a', 'b', 'c']);

    state = unwrap(decide(game, state, 'b', 5)); // any order
    assert.deepEqual(game.activePlayers(state), ['a', 'c']);
    assert.deepEqual(state.game.totals, { a: 0, b: 0, c: 0 }); // nothing processed yet

    state = unwrap(decide(game, state, 'c', 2));
    state = unwrap(decide(game, state, 'a', 1, 2500));
    assert.deepEqual(state.game.totals, { a: 1, b: 5, c: 2 });
    assert.deepEqual(state.game.log, [{ missing: [], timedOut: false }]);
    assert.equal(state.round, 2);
    assert.equal(state.roundStartedAt, 2500);
    assert.deepEqual(state.decisions, {});
    assert.deepEqual(game.activePlayers(state), ['a', 'b', 'c']);
  });

  it('rejects invalid decisions without recording them', () => {
    const game = sumGame();
    const state = start(game);
    assert.equal(decide(game, state, 'a', 'seven').ok, false);
  });

  it('locks decisions by default', () => {
    const game = sumGame();
    const state = unwrap(decide(game, start(game), 'a', 1));
    assert.deepEqual(game.activePlayers(state), ['b', 'c']);
    const again = decide(game, state, 'a', 9);
    assert.equal(again.ok, false);
  });

  it('allowRevision lets players change their mind until the round resolves', () => {
    const game = sumGame({ allowRevision: true });
    let state = unwrap(decide(game, start(game), 'a', 1));
    assert.deepEqual(game.activePlayers(state), ['a', 'b', 'c']); // a may still act
    state = unwrap(decide(game, state, 'a', 9));
    state = unwrap(decide(game, state, 'b', 0));
    state = unwrap(decide(game, state, 'c', 0));
    assert.equal(state.game.totals.a, 9);
  });

  it('view hides other players’ pending decisions', () => {
    const game = sumGame();
    let state = unwrap(decide(game, start(game), 'a', 42));
    const asA = game.view!(state, 'a') as SimultaneousView<number>;
    const asB = game.view!(state, 'b') as SimultaneousView<number>;
    const asSpectator = game.view!(state, null) as SimultaneousView<number>;

    assert.equal(asA.yourDecision, 42);
    assert.equal(asB.yourDecision, null);
    assert.equal(asSpectator.yourDecision, null);
    assert.deepEqual(asB.decided, ['a']);
    assert.deepEqual(asB.waitingOn, ['b', 'c']);
    for (const v of [asB, asSpectator]) assert.ok(!JSON.stringify(v).includes('42'));
  });

  it('only asks the deciders the game names', () => {
    const game = sumGame();
    let state = start(game);
    state = { ...state, game: { ...state.game, eliminated: ['b'] } };
    assert.deepEqual(game.activePlayers(state), ['a', 'c']);
    state = unwrap(decide(game, state, 'a', 1));
    state = unwrap(decide(game, state, 'c', 1));
    assert.equal(state.round, 2); // resolved without b
  });

  it('stops accepting decisions once the game is over', () => {
    const game = sumGame();
    let state = start(game, ['a', 'b']);
    for (let round = 0; round < 2; round++) {
      state = unwrap(decide(game, state, 'a', 1));
      state = unwrap(decide(game, state, 'b', 1));
    }
    assert.deepEqual(game.outcome(state), { draw: true });
    assert.deepEqual(game.activePlayers(state), []);
  });

  describe('time limits', () => {
    it('has no deadline hooks unless timeLimitMs is given', () => {
      const game = sumGame();
      assert.equal(game.deadline, undefined);
      assert.equal(game.onDeadline, undefined);
    });

    it('sets a per-round deadline and resolves with whoever decided when it passes', () => {
      const game = sumGame({ timeLimitMs: 30_000 });
      let state = start(game, ['a', 'b', 'c'], 1000);
      assert.equal(game.deadline!(state), 31_000);

      state = unwrap(decide(game, state, 'a', 4, 5000));
      assert.equal(game.deadline!(state), 31_000); // deciding doesn't extend the round

      state = game.onDeadline!(state, { now: 31_000 });
      assert.deepEqual(state.game.totals, { a: 4, b: 0, c: 0 });
      assert.deepEqual(state.game.log, [{ missing: ['b', 'c'], timedOut: true }]);
      assert.equal(state.round, 2);
      assert.equal(game.deadline!(state), 61_000); // next round's clock starts now
      assert.equal((game.view!(state, null) as SimultaneousView<number>).roundDeadline, 61_000);
    });

    it('has no deadline once the game is over', () => {
      const game = sumGame({ timeLimitMs: 10 });
      let state = start(game, ['a', 'b']);
      state = game.onDeadline!(state, { now: 2000 });
      state = game.onDeadline!(state, { now: 3000 });
      assert.notEqual(game.outcome(state), null);
      assert.equal(game.deadline!(state), null);
    });
  });
});
