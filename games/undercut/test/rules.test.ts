import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Result, SimultaneousView } from '@gs/sdk';
import {
  DECK,
  ranking,
  roundWinner,
  undercut,
  type Decision,
  type UndercutGame,
  type UndercutState,
} from '../src/index.ts';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function start(players: string[], config: unknown = {}, now = 0): UndercutState {
  return undercut.setup({ players, config: unwrap(undercut.parseConfig!(config)), seed: 's', now });
}

/** Submit decisions in order, parsing then applying, as the server does. */
function decide(state: UndercutState, decisions: Record<string, unknown>, now = 0): UndercutState {
  for (const [player, input] of Object.entries(decisions)) {
    const decision = unwrap(undercut.parseMove(input, state, player));
    state = unwrap(undercut.applyMove(state, decision, player, { now }));
  }
  return state;
}

/** One full round: each player reveals `card` plus their highest other card, then plays `card`. */
function playRound(state: UndercutState, cards: Record<string, number>): UndercutState {
  const picks = Object.fromEntries(
    Object.entries(cards).map(([p, card]) => {
      const other = Math.max(...state.game.seats[p]!.hand.filter((c) => c !== card));
      return [p, { pick: [card, other] }];
    }),
  );
  state = decide(state, picks);
  return decide(state, Object.fromEntries(Object.entries(cards).map(([p, card]) => [p, { play: card }])));
}

const view = (state: UndercutState, viewer: string | null) =>
  undercut.view!(state, viewer) as SimultaneousView<Decision> & { game: UndercutGame };

describe('undercut rules', () => {
  it('the lowest unique card wins; matched cards cancel out', () => {
    assert.equal(roundWinner({ a: 1, b: 2, c: 3 }), 'a');
    assert.equal(roundWinner({ a: 1, b: 1, c: 3, d: 5 }), 'c');
    assert.equal(roundWinner({ a: 2, b: 2, c: 4, d: 4 }), null);
  });

  it('validates config', () => {
    assert.deepEqual(unwrap(undercut.parseConfig!(undefined)), { cycles: 3, decisionTimeMs: null });
    for (const bad of [{ cycles: 0 }, { cycles: 6 }, { cycles: 1.5 }, { decisionTimeMs: 0 }, { decisionTimeMs: '5' }]) {
      assert.equal(undercut.parseConfig!(bad).ok, false, JSON.stringify(bad));
    }
  });

  it('validates picks', () => {
    const state = start(['a', 'b', 'c']);
    for (const bad of [
      { pick: [1] },
      { pick: [1, 2, 3] },
      { pick: [3, 3] },
      { pick: [0, 9] },
      { pick: ['1', 2] },
      {},
      null,
    ]) {
      assert.equal(undercut.parseMove(bad, state, 'a').ok, false, JSON.stringify(bad));
    }
    assert.deepEqual(unwrap(undercut.parseMove({ pick: [5, 2] }, state, 'a')), { pick: [2, 5] }); // sorted
  });

  it('picks stay hidden until everyone has picked, then the pairs are revealed', () => {
    let state = decide(start(['a', 'b', 'c']), { a: { pick: [1, 2] } });
    for (const viewer of ['b', null]) {
      assert.equal(view(state, viewer).yourDecision, null);
      assert.deepEqual(view(state, viewer).game.pairs, {});
      assert.doesNotMatch(JSON.stringify(view(state, viewer)), /"pick":/);
    }
    assert.deepEqual(view(state, 'a').yourDecision, { pick: [1, 2] });
    assert.deepEqual(view(state, 'b').waitingOn, ['b', 'c']);

    state = decide(state, { b: { pick: [3, 4] }, c: { pick: [7, 8] } });
    assert.equal(state.game.step, 'play');
    assert.deepEqual(state.game.pairs, { a: [1, 2], b: [3, 4], c: [7, 8] });
  });

  it('you can only play a card from your revealed pair', () => {
    const state = decide(start(['a', 'b', 'c']), { a: { pick: [1, 2] }, b: { pick: [3, 4] }, c: { pick: [7, 8] } });
    for (const bad of [{ play: 3 }, { play: '1' }, { pick: [1, 2] }, {}]) {
      assert.equal(undercut.parseMove(bad, state, 'a').ok, false, JSON.stringify(bad));
    }
  });

  it('the winner earns a token; only the played card is discarded', () => {
    let state = decide(start(['a', 'b', 'c']), { a: { pick: [1, 2] }, b: { pick: [1, 3] }, c: { pick: [2, 8] } });
    state = decide(state, { a: { play: 1 }, b: { play: 1 }, c: { play: 2 } }); // the 1s cancel, so 2 wins

    const { game } = state;
    assert.equal(game.round, 2);
    assert.equal(game.step, 'pick');
    assert.deepEqual(game.pairs, {});
    assert.equal(game.seats.c!.tokens, 1);
    assert.equal(game.seats.c!.lastWin, 1);
    assert.equal(game.seats.a!.tokens, 0);
    assert.deepEqual(game.seats.a!.hand, [2, 3, 4, 5, 6, 7, 8]); // 2 went back to the hand
    assert.deepEqual(game.history, [
      {
        round: 1,
        pairs: { a: [1, 2], b: [1, 3], c: [2, 8] },
        played: { a: 1, b: 1, c: 2 },
        winner: 'c',
        autoPlayed: [],
      },
    ]);
  });

  it('ties in the ranking go to the most recent round win', () => {
    let state = start(['a', 'b', 'c']);
    state = playRound(state, { a: 1, b: 2, c: 2 });
    state = playRound(state, { a: 3, b: 1, c: 3 });
    assert.deepEqual(ranking(state.game, ['a', 'b', 'c']), ['b', 'a', 'c']);
  });

  it('the leader after a cycle is safe and leaves; hands refill; the last cycle decides the game', () => {
    let state = start(['a', 'b', 'c', 'd'], { cycles: 2 });
    // Cycle 1: b, c and d always match each other, so a wins every round.
    for (let r = 1; r <= 6; r++) state = playRound(state, { a: r, b: 9 - r, c: 9 - r, d: 9 - r });

    assert.equal(state.game.round, 7);
    assert.deepEqual(state.game.cycleResults, [{ cycle: 1, safe: 'a' }]);
    assert.equal(state.game.seats.a!.status, 'safe');
    assert.deepEqual(view(state, null).deciders, ['b', 'c', 'd']);
    for (const p of ['b', 'c', 'd']) assert.deepEqual(state.game.seats[p]!.hand, DECK);
    assert.equal(undercut.outcome(state), null);

    // Cycle 2: b wins every round; c and d never win, so they tie for last.
    for (let r = 1; r <= 6; r++) state = playRound(state, { b: r, c: 9 - r, d: 9 - r });

    const { game } = state;
    assert.equal(game.finished, true);
    assert.deepEqual(game.cycleResults.at(-1), { cycle: 2, safe: null });
    assert.deepEqual(Object.fromEntries(Object.entries(game.seats).map(([p, s]) => [p, s.status])), {
      a: 'safe',
      b: 'winner',
      c: 'eliminated',
      d: 'eliminated',
    });
    assert.deepEqual(undercut.outcome(state), { winners: ['b'] });
    assert.deepEqual(undercut.activePlayers(state), []);
  });

  it('nobody is safe when the lead is tied or only two players would remain', () => {
    // Everyone plays the same card every round, so nobody ever wins.
    let state = start(['a', 'b', 'c'], { cycles: 3 });
    for (let r = 1; r <= 6; r++) state = playRound(state, { a: r, b: r, c: r });
    assert.deepEqual(state.game.cycleResults, [{ cycle: 1, safe: null }]);

    // Cycle 2: a wins every round and leaves, which still leaves two players.
    for (let r = 1; r <= 6; r++) state = playRound(state, { a: r, b: 9 - r, c: 9 - r });
    assert.deepEqual(state.game.cycleResults.at(-1), { cycle: 2, safe: 'a' });

    // Cycle 3 is the last: b wins it; c is eliminated.
    for (let r = 1; r <= 6; r++) state = playRound(state, { b: r, c: 9 - r });
    assert.deepEqual(undercut.outcome(state), { winners: ['b'] });
    assert.equal(state.game.seats.c!.status, 'eliminated');
  });

  it('with two players left, the leader stays in', () => {
    let state = start(['a', 'b', 'c'], { cycles: 3 });
    for (let r = 1; r <= 6; r++) state = playRound(state, { a: r, b: 9 - r, c: 9 - r });
    assert.equal(state.game.seats.a!.status, 'safe');
    for (let r = 1; r <= 6; r++) state = playRound(state, { b: r, c: 9 - r });
    assert.deepEqual(state.game.cycleResults.at(-1), { cycle: 2, safe: null });
    assert.equal(state.game.seats.b!.status, 'playing');
  });

  it('a final cycle nobody wins ends with everyone tied: all win, nobody is eliminated', () => {
    let state = start(['a', 'b', 'c'], { cycles: 1 });
    for (let r = 1; r <= 6; r++) state = playRound(state, { a: r, b: r, c: r });
    assert.deepEqual(undercut.outcome(state), { winners: ['a', 'b', 'c'] });
  });

  it('on timeout, missing players reveal their two highest cards, then play the higher one', () => {
    let state = start(['a', 'b', 'c'], { decisionTimeMs: 1000 }, 0);
    assert.equal(undercut.deadline!(state), 1000);

    state = decide(state, { a: { pick: [1, 2] } }, 10);
    state = undercut.onDeadline!(state, { now: 1000 });
    assert.deepEqual(state.game.pairs, { a: [1, 2], b: [7, 8], c: [7, 8] });
    assert.equal(undercut.deadline!(state), 2000);

    state = decide(state, { a: { play: 2 } }, 1500);
    state = undercut.onDeadline!(state, { now: 2000 });
    const result = state.game.history[0]!;
    assert.deepEqual(result.played, { a: 2, b: 8, c: 8 });
    assert.deepEqual(result.autoPlayed, ['b', 'c']);
    assert.equal(result.winner, 'a');
  });

  it('state survives JSON round trips', () => {
    let state = start(['a', 'b', 'c']);
    state = playRound(state, { a: 1, b: 2, c: 3 });
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  });
});
