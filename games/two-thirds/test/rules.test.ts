import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Result } from '@gs/sdk';
import { scoreRound, twoThirds, type TwoThirdsState } from '../src/index.ts';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function start(players: string[], config: unknown = {}, now = 0): TwoThirdsState {
  return twoThirds.setup({ players, config: unwrap(twoThirds.parseConfig!(config)), seed: 's', now });
}

function round(state: TwoThirdsState, guesses: Record<string, number>, now = 0): TwoThirdsState {
  for (const [player, guess] of Object.entries(guesses)) {
    const decision = unwrap(twoThirds.parseMove({ guess }, state, player)); // parse then apply, as the server does
    state = unwrap(twoThirds.applyMove(state, decision, player, { now }));
  }
  return state;
}

describe('two-thirds rules', () => {
  it('scores the guess closest to 2/3 of the average', () => {
    // average 30, target 20 → 21 is closest
    const result = scoreRound({ a: 0, b: 21, c: 69 }, []);
    assert.equal(result.average, 30);
    assert.equal(result.target, 20);
    assert.deepEqual(result.winners, ['b']);
  });

  it('ties share the point', () => {
    const result = scoreRound({ a: 15, b: 25, c: 50 }, []); // avg 30, target 20; a and b are both 5 away
    assert.deepEqual(result.winners, ['a', 'b']);
  });

  it('a round with no guesses has no winner', () => {
    assert.deepEqual(scoreRound({}, ['a', 'b']).winners, []);
  });

  it('validates config', () => {
    assert.equal(twoThirds.parseConfig!({ rounds: 0 }).ok, false);
    assert.equal(twoThirds.parseConfig!({ rounds: 21 }).ok, false);
    assert.equal(twoThirds.parseConfig!({ roundTimeMs: -5 }).ok, false);
    assert.deepEqual(unwrap(twoThirds.parseConfig!(undefined)), { rounds: 3, roundTimeMs: null });
  });

  it('validates guesses', () => {
    const state = start(['a', 'b']);
    for (const bad of [{ guess: -1 }, { guess: 101 }, { guess: 2.5 }, { guess: '5' }, {}, null]) {
      assert.equal(twoThirds.parseMove(bad, state, 'a').ok, false, JSON.stringify(bad));
    }
  });

  it('players can revise until the last guess is in', () => {
    let state = start(['a', 'b', 'c'], { rounds: 1 });
    state = round(state, { a: 90 });
    state = round(state, { a: 0 }); // changed mind
    state = round(state, { b: 21, c: 69 });
    assert.deepEqual(state.game.history[0]!.guesses, { a: 0, b: 21, c: 69 });
  });

  it('plays several rounds to a winner', () => {
    let state = start(['a', 'b', 'c'], { rounds: 2 });
    state = round(state, { a: 0, b: 21, c: 69 }); // b
    assert.equal(twoThirds.outcome(state), null);
    state = round(state, { a: 10, b: 50, c: 90 }); // avg 50, target 33.3 → b (50 is 16.7 away, a is 23.3)
    assert.deepEqual(state.game.scores, { a: 0, b: 2, c: 0 });
    assert.deepEqual(twoThirds.outcome(state), { winners: ['b'] });
    assert.deepEqual(twoThirds.activePlayers(state), []);
  });

  it('with a round timer, missing players sit the round out', () => {
    let state = start(['a', 'b', 'c'], { rounds: 2, roundTimeMs: 30_000 }, 1000);
    assert.equal(twoThirds.deadline!(state), 31_000);
    state = round(state, { a: 30, b: 60 }, 5000);
    state = twoThirds.onDeadline!(state, { now: 31_000 });

    const [result] = state.game.history;
    assert.deepEqual(result!.missing, ['c']);
    assert.equal(result!.average, 45); // c's absence doesn't count as a guess
    assert.deepEqual(result!.winners, ['a']);
    assert.equal(twoThirds.deadline!(state), 61_000);
  });

  it('handles many players', () => {
    const players = Array.from({ length: 20 }, (_, i) => `p${i + 1}`);
    let state = start(players, { rounds: 1 });
    state = round(state, Object.fromEntries(players.map((p, i) => [p, i * 5])));
    assert.equal(state.game.history.length, 1);
    assert.notEqual(twoThirds.outcome(state), null);
  });
});
