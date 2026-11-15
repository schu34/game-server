import { defineGame, err, ok, type Outcome, type PlayerId } from '@gs/sdk';

export type Mark = 'X' | 'O';
export type Cell = Mark | null;

export type TicTacToeState = {
  board: Cell[];
  marks: { [player: PlayerId]: Mark };
  turn: PlayerId;
};

export type TicTacToeMove = { cell: number };

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
] as const;

export function winningMark(board: readonly Cell[]): Mark | null {
  for (const [a, b, c] of LINES) {
    const mark = board[a];
    if (mark && mark === board[b] && mark === board[c]) return mark;
  }
  return null;
}

function outcome(state: TicTacToeState): Outcome | null {
  const mark = winningMark(state.board);
  if (mark) {
    const winner = Object.keys(state.marks).find((player) => state.marks[player] === mark)!;
    return { winners: [winner] };
  }
  return state.board.every((cell) => cell !== null) ? { draw: true } : null;
}

export const ticTacToe = defineGame<TicTacToeState, TicTacToeMove>({
  type: 'tic-tac-toe',
  minPlayers: 2,
  maxPlayers: 2,

  setup({ players }) {
    const [x, o] = players as [PlayerId, PlayerId];
    return { board: Array<Cell>(9).fill(null), marks: { [x]: 'X', [o]: 'O' }, turn: x };
  },

  parseMove(input, state) {
    const cell = (input as { cell?: unknown } | null)?.cell;
    if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) > 8) return err('Move must be { "cell": 0-8 }');
    if (state.board[cell as number] !== null) return err(`Cell ${cell} is already taken`);
    return ok({ cell: cell as number });
  },

  applyMove(state, { cell }, player) {
    const board = state.board.slice();
    board[cell] = state.marks[player]!;
    const next = Object.keys(state.marks).find((p) => p !== player)!;
    return ok({ ...state, board, turn: next });
  },

  activePlayers(state) {
    return outcome(state) ? [] : [state.turn];
  },

  outcome,
});

/** Render a board as text, e.g. for a CLI. */
export function renderBoard(board: readonly Cell[]): string {
  const rows = [0, 3, 6].map((start) =>
    board
      .slice(start, start + 3)
      .map((cell, i) => ` ${cell ?? start + i} `)
      .join('|'),
  );
  return rows.join('\n---+---+---\n');
}
