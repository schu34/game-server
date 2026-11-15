import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Result } from '@gs/sdk';
import { ticTacToe, type TicTacToeState } from '../src/index.ts';

const setup = () => ticTacToe.setup({ players: ['p1', 'p2'], config: null, seed: 'x' });

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** Parse then apply, the way the server does. */
function move(state: TicTacToeState, input: unknown, player = state.turn): TicTacToeState {
  return unwrap(ticTacToe.applyMove(state, unwrap(ticTacToe.parseMove(input, state, player)), player));
}

function play(cells: number[]): TicTacToeState {
  let state = setup();
  for (const cell of cells) state = move(state, { cell });
  return state;
}

describe('tic-tac-toe rules', () => {
  it('starts with an empty board and p1 (X) to move', () => {
    const state = setup();
    assert.deepEqual(state.board, Array(9).fill(null));
    assert.deepEqual(state.marks, { p1: 'X', p2: 'O' });
    assert.deepEqual(ticTacToe.activePlayers(state), ['p1']);
    assert.equal(ticTacToe.outcome(state), null);
  });

  it('alternates turns and does not mutate the previous state', () => {
    const before = setup();
    const after = move(before, { cell: 4 }, 'p1');
    assert.equal(before.board[4], null);
    assert.equal(after.board[4], 'X');
    assert.deepEqual(ticTacToe.activePlayers(after), ['p2']);
  });

  it('rejects malformed moves and taken cells', () => {
    const state = play([4]);
    for (const bad of [null, {}, { cell: -1 }, { cell: 9 }, { cell: 1.5 }, { cell: '3' }, 3]) {
      assert.equal(ticTacToe.parseMove(bad, state, 'p2').ok, false, `accepted ${JSON.stringify(bad)}`);
    }
    const taken = ticTacToe.parseMove({ cell: 4 }, state, 'p2');
    assert.deepEqual(taken, { ok: false, error: 'Cell 4 is already taken' });
  });

  it('takes no config', () => {
    assert.equal(ticTacToe.parseConfig(undefined).ok, true);
    assert.equal(ticTacToe.parseConfig({ size: 4 }).ok, false);
  });

  it('detects a row win', () => {
    const state = play([0, 3, 1, 4, 2]); // X: 0,1,2
    assert.deepEqual(ticTacToe.outcome(state), { winners: ['p1'] });
    assert.deepEqual(ticTacToe.activePlayers(state), []);
  });

  it('detects a diagonal win for O', () => {
    const state = play([0, 2, 1, 4, 8, 6]); // O: 2,4,6
    assert.deepEqual(ticTacToe.outcome(state), { winners: ['p2'] });
  });

  it('detects a draw', () => {
    // X O X / X O O / O X X
    const state = play([0, 1, 2, 4, 3, 5, 7, 6, 8]);
    assert.deepEqual(ticTacToe.outcome(state), { draw: true });
  });

  it('state is JSON round-trippable', () => {
    const state = play([0, 4, 8]);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  });
});
