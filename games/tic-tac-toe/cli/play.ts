/**
 * Scripted demo: two bots play tic-tac-toe against a running server,
 * while a spectator subscription prints every state pushed over SSE.
 *
 *   pnpm run dev           # in one terminal
 *   pnpm run demo [url]    # in another (default http://localhost:3000)
 */
import type { GameView } from '@gs/sdk';
import { GameServer } from '@gs/client';
import { renderBoard, type TicTacToeMove, type TicTacToeState } from '../src/index.ts';

const baseUrl = process.argv[2] ?? 'http://localhost:3000';
const server = new GameServer(baseUrl);

const game = await server.create('tic-tac-toe');
console.log(`Created game ${game.id}`);

let finished!: () => void;
const gameOver = new Promise<void>((resolve) => (finished = resolve));
const subscription = await server.spectate<TicTacToeState>(game.id).subscribe((view: GameView<TicTacToeState>) => {
  console.log(`\n[v${view.version}] status=${view.status} active=${view.activePlayers.join(',') || '-'}`);
  if (view.status !== 'lobby') console.log(renderBoard(view.state.board));
  if (view.status === 'finished') finished();
});

const alice = await server.join<TicTacToeState, TicTacToeMove>(game.id, 'Alice');
const bob = await server.join<TicTacToeState, TicTacToeMove>(game.id, 'Bob'); // fills the game, which auto-starts it
const players = new Map([
  [alice.playerId, alice],
  [bob.playerId, bob],
]);

for (;;) {
  const view = (await alice.get())!;
  if (view.status === 'finished') break;
  if (view.status === 'lobby') throw new Error('game did not start');
  const empty = view.state.board.flatMap((cell, i) => (cell === null ? [i] : []));
  const cell = empty[Math.floor(Math.random() * empty.length)]!;
  await players.get(view.activePlayers[0]!)!.move({ cell });
  await new Promise((r) => setTimeout(r, 150));
}

await gameOver;
subscription.close();

const final = (await alice.get())!;
const names = Object.fromEntries(final.players.map((p) => [p.id, p.name]));
const outcome = final.outcome!;
console.log('\n' + ('draw' in outcome ? 'Draw!' : `${outcome.winners.map((id) => names[id]).join(', ')} wins!`));
